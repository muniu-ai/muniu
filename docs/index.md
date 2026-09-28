# 木牛文档

木牛 Agent OS 0.2 是持久 Agent 执行平台。Desktop、CLI 与 API 通过 Host 使用同一套工作区、执行、审批和恢复能力；OPC 与 Coding 提供具体业务流程。

## 按任务开始

| 读者与目标 | 阅读路径 | 完成后得到什么 |
| --- | --- | --- |
| 使用者：第一次启动 | [快速开始](./quickstart.md) → [OPC](./guides/opc.md) 或 [Coding](./guides/coding.md) | 可连接的本机 Host、工作区与第一个任务 |
| 脚本使用者：操作已有服务 | [CLI 使用](./guides/cli.md) → [CLI 参考](./reference/cli.md) 或 [API 路由](./reference/api-routes.md) | 明确的参数、返回格式与并发规则 |
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
- [工程验收记录](./verification/application-boundaries-2026-09-28.md)：查看对应提交的实际检查及未完成项。
- [工业询价专项](./industry-delivery/README.md)：双仓库参考应用、合成样本和发布门禁；它不是首次使用木牛的前置条件。

## 如何判断一份资料的适用范围

本目录的指南描述当前源码使用方式，参考文档记录接口。ADR 记录采用理由，验收记录只说明其日期、提交和环境下的结果。工业询价目录中的固定基线、样本与历史结果按原记录解释，不代表当前主分支或生产环境自动通过。
