# 统一任务入口验证记录

日期：2026-10-10。源码基线：`37e8108`。范围见[实施计划](../proposals/unified-task-workspace-2026-10-10.md)。

## 行为

全局“委派任务”和任务页统一经营与研发输入，支持文本资料、经营汇总快照、验收要求、约束、模型、额度与时限。准备计划只保存任务；确认启动后才调用模型。同页展示执行会话、成果和逐项验收。经营任务使用独立经营助手，不再默认创建机会验证对象；研发任务继续绑定已登记仓库。

新增 Host/Worker 测试先因经营目标仍选择机会验证助手而失败，实现后通过。真实 Host UI 测试覆盖资料读取与拒绝不支持的格式、跨页保留草稿、服务端成功但响应丢失后的同键重试、确认前不调用模型、启动执行、成果验收、Markdown 安全展示与下载，以及执行结束后不能隐式启动预算外任务。非默认模型回归先复现计划页显示错误模型，修复后通过。原有权限失效、旧响应覆盖、成果版本和验收竞态检查继续通过。

## 检查结果

| 检查 | 结果 |
| --- | --- |
| 锁定依赖安装 | `npm ci` 通过；Node.js 22.19.0、npm 11.10.1、TypeScript 5.7.2 |
| `npm test` | 797 项通过，0 失败 |
| `npm run verify:plugins` | Plugin SDK、插件套件与 Host 测试通过 |
| `npm run typecheck` | 通过 |
| `npm run typecheck:desktop`、`npm run build:desktop` | 通过 |
| `npm run verify:tasks-ui`、`npm run verify:goals-ui` | 通过；真实 Host 与隔离数据，模型输出由测试服务提供 |
| 仓库、研发、经营、机会验证和首次设置 UI 门禁 | 全部通过 |
| Rust crate 下 `cargo check --locked`、`cargo test --locked` | 通过，9 项测试通过 |
| `npm audit --omit=dev` | 0 项漏洞 |
| 文档检查、链接和构建 | 通过 |
| `npm run verify:enterprise-fixture` | 静态与 Helm 检查通过；容器阶段因当前 shell 的 Docker 命令链接失效而未完成 |
| `npm run verify:kind` | 环境检查报告缺少可执行的 Docker 命令，未创建集群 |
| universal macOS 应用 | arm64/x86_64 构建与本地签名校验通过 |
| `npm run verify:mac-packaged-app` | 新应用受管 Host、数据库隔离、首次设置重放和经营流程通过；脚本同时校验已有 DMG，本次未重新生成 DMG |
| 安装后的 `doctor --json` | `ok=true`、核心服务 `healthy`、就绪检查 `ready=true` |

## 本机安装与核对

关闭旧版后，将应用和 `~/.muniu/v2` 备份至用户 Library 下的 Muniu/Backups 独立目录，再更新 `/Applications/木牛.app`。主程序、Host 和图标摘要与构建产物一致，签名校验通过；安装记录和诊断结果留在权限受限的备份目录。

原生窗口实测确认“委派任务”打开统一任务页，经营模板、资料入口、验收要求、可用模型和费用时限正常显示。切换研发显示已登记仓库与“添加仓库”入口，返回经营保留空白编辑器。没有提交真实模型任务，也没有新增或修改用户经营记录。

本次为本地开发签名安装，未进行 Apple Developer ID 公证或远程发布。附件当前限 UTF-8 文本；外部 CLI Agent 仍从研发任务详情调度，未声称统一计划已经支持所有外部 Agent。

Host sidecar 已构建；未单独重复 `build:host-sidecar -- --smoke`，其启动健康检查由以上打包应用测试覆盖，并增加了进程归属与数据库隔离核对。
