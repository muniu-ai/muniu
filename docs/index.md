# 木牛文档

木牛 Agent OS 0.2 是持久 Agent 执行平台。Desktop、CLI 与 API 通过 Host 使用同一套工作区、执行、审批和恢复能力；OPC 与 Coding 提供具体业务流程。

## 按任务开始

| 读者与目标 | 阅读路径 | 完成后得到什么 |
| --- | --- | --- |
| 使用者：第一次启动 | [快速开始](./quickstart.md) → [OPC 经营管理](./guides/business.md) 或 [Coding](./guides/coding.md) | 可连接的本机 Host、工作区与第一个任务 |
| 脚本使用者：操作已有服务 | [CLI 使用](./guides/cli.md) → [CLI 参考](./reference/cli.md) 或 [API 路由](./reference/api-routes.md) | 明确的参数、返回格式与并发规则 |
| 使用者：按目标执行并接收成果 | [目标与验收](./guides/goals.md) | 单 Agent 或显式固定团队计划、进度和逐项验收 |
| 开发者：定位代码和修改行为 | [核心概念](./concepts.md) → [架构](./architecture.md) → [开发指南](./development.md) | 模块职责、事实来源与验证命令 |
| Agent：接手仓库任务 | [仓库规则](https://github.com/muniu-ai/muniu/blob/main/AGENTS.md) → [Agent 工作指南](./agent-guide.md) | 最小阅读路径、改动边界与交付要求 |
| 插件作者：增加业务能力 | [插件开发](./plugin-authoring.md) → [插件运维](./reference/plugins.md) | 公共 SDK 边界、签名与生命周期规则 |
| 运维人员：部署和恢复 | [企业运维](./enterprise-operations.md) → [安全边界](./security/overview.md) | 部署依赖、维护操作与验收条件 |

不确定某项能力是否已经可用，先看[能力与验证状态](./status.md)。遇到错误，按[故障排查](./troubleshooting.md)中的症状定位。

## 查阅契约

| 问题 | 文档 |
| --- | --- |
| HTTP 路径、权限、幂等与并发参数 | [API 路由](./reference/api-routes.md) · [OpenAPI](./reference/openapi.md) |
| CLI 命令和参数 | [CLI 参考](./reference/cli.md) |
| 事件、版本、SSE 游标和恢复代际 | [事件与恢复](./reference/events.md) |
| 哪些工具需要审批，结果未知如何处理 | [工具与审批](./reference/tools.md) |
| 插件安装、停用和升级 | [插件运维](./reference/plugins.md) |
| 端口、状态目录、密钥和环境变量 | [配置参考](./reference/configuration.md) |

CLI 帮助、API 路由表、OpenAPI 和内置插件目录由源码生成。改动接口时按[开发指南](./development.md)更新来源并重新生成，不直接修改生成区块。

## 部署、发布与专项资料

- [安全边界](./security/overview.md)、[日志脱敏](./security/redaction-policy.md)、[密钥扫描](./security/secret-scanning.md)：理解信任与数据处理规则。
- [macOS 发布](./release/macos.md)、[签名与公证](./release/apple-developer-id.md)：制作和验收安装包；源码构建成功不代表已完成分发验收。
- [架构决策](./adr/index.md)：理解已采用的版本和模块边界。
- [经营到交付实施计划](./proposals/agent-os-delivery-2026-10-10.md)：当前获批 P0—P5 分期；P2 固定团队的进度与未验证项见[本轮记录](./verification/agent-os-p2-2026-10-10.md)。
- [多 Agent、多模型提案](./proposals/agent-os-multi-agent-optimization-2026-10-09.md)：总体设计与分期；本次采用范围见 [S0 复用审查](./verification/agent-os-s0-reuse-2026-10-09.md)、[S1 决策](./adr/0013-goal-delivery-orchestration.md)和[验证记录](./verification/agent-os-s1-2026-10-09.md)。
- [OPC 经营管理体系](./proposals/opc-business-management-2026-10-09.md)：完整经营领域、曾鸣著作依据及产品实施分期。
- [工程验收记录](./verification/application-boundaries-2026-09-28.md)：查看对应提交的实际检查及未完成项。
- [仓库登记体验验证](./verification/repository-registration-ux-2026-10-10.md)：快速登记、原生文件夹选择和重试检查。
- [统一 Agent 调度](./proposals/roi-agent-scheduling-2026-10-10.md)与[验证记录](./verification/roi-agent-scheduling-2026-10-10.md)：质量优先、CLI 费用核对和本机安装结果。
- [工业询价专项](./industry-delivery/README.md)：双仓库参考应用、合成样本和发布门禁；它不是首次使用木牛的前置条件。

## 如何判断一份资料的适用范围

本目录的指南描述当前源码使用方式，参考文档记录接口。ADR 记录采用理由，验收记录只说明其日期、提交和环境下的结果。工业询价目录中的固定基线、样本与历史结果按原记录解释，不代表当前主分支或生产环境自动通过。

模型厂商接入与 Codex、Claude Code 调度状态检查见[模型与外部 Agent](guides/agents-and-models.md)。
