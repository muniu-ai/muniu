# 统一 Agent 调度验证记录

日期：2026-10-10。源码基线：`ade0f6e`，范围见[实施计划](../proposals/roi-agent-scheduling-2026-10-10.md)。Node.js 22.19.0、npm 11.10.1、TypeScript 5.7.2；依赖由 `npm ci` 安装。

## 行为与证据

经营与研发任务支持自动推荐、内置 Agent、Codex CLI 和 Claude Code。默认质量优先，推荐结果包含同类任务样本、验收率保守下界、费用、耗时和排除原因。没有足够记录时明确显示初始估计；费用未知的 CLI 只能先由用户指定。完成价值与时间成本为可选输入，ROI 是估计值。

TDD 覆盖质量排序、冷启动、预算与币种、未知费用、零验收及浮点边界。Host 测试覆盖计划重复请求、配置变化后拒绝旧授权、执行中补充说明、外部用量登记与禁止覆盖。真实 Worker 使用本机编译的合成 CLI 验证经营答复、无需 BYOK、隔离目录之外文件读取被拒绝、拒绝批准不启动，以及未知结果不重放；研发继续通过受控仓库、Gate、候选批准及恢复套件。没有用这些合成结果宣称厂商账号已经验证。

真实 Host 的界面测试覆盖默认质量优先、手动 CLI 不要求木牛模型、保留模型偏好、计划依据、资料、幂等重试、执行、逐条验收和成果下载。外部费用提交的权限和状态约束由 Host 测试验证。

## 检查结果

| 检查 | 结果 |
| --- | --- |
| `npm test` | 最终 816 项通过，0 失败、0 跳过；更新了原诊断测试中仅限 Coding 的旧 fixture |
| `npm run typecheck` | 通过 |
| `npm run typecheck:desktop`、`npm run build:desktop` | 通过；构建仍提示前端单文件超过 500 kB |
| `npm run verify:plugins` | 通过 |
| `verify:tasks-ui`、`verify:goals-ui`、`verify:repositories-ui` | 通过 |
| `verify:opc-ui`、`verify:coding-ui`、`verify:business-ui`、`verify:onboarding-ui` | 通过 |
| Rust crate 下 `cargo check --locked`、`cargo test --locked` | 通过，9 项测试通过 |
| `npm audit --omit=dev` | 0 项漏洞 |
| 文档生成检查、链接、构建与中文检查 | 通过 |
| `npm run verify:enterprise-fixture` | 静态 fixture 与 Helm 通过；容器阶段因 Docker 命令不可用而未完成 |
| `npm run verify:kind` | 缺少 Docker，未创建集群 |
| universal macOS `.app` | arm64/x86_64 构建与本地 ad-hoc 签名验证通过 |
| `npm run verify:mac-packaged-app` | 新应用受管 Host、数据库隔离、首次设置重放和经营流程通过；脚本另校验已有 DMG，本次未重新制作 DMG |
| 安装后 `doctor --json` | `ok=true`、核心服务 `healthy`、`ready=true` |

Host sidecar 已重建，未单独重复 `--smoke`，启动检查由打包应用测试覆盖。没有进行真实厂商付费调用、Apple Developer ID 公证、远程推送或公开发布。

## 本机安装

确认没有运行中的任务后退出旧应用，备份原 `.app` 和 `~/.muniu/v2`，再替换 `/Applications/木牛.app`。备份位于用户 Library 的 `Muniu/Backups/roi-agent-scheduling-2026-10-10T04-29-21-225Z`，保留安装摘要与诊断结果。主程序、Host 和白底图标均与构建产物摘要一致。

安装后的原生窗口确认“交给谁来完成”默认自动推荐与质量优先，提供内置 Agent、Codex CLI、Claude Code；选择外部 CLI 后隐藏木牛模型选择并显示账户、批准和费用说明。检查后恢复默认选择，未创建真实任务。

当前统计参数与任务分组尚未经过实际业务基准校准；外部 CLI 费用不能实时强制限额，未知结果的经营 CLI 暂无强制成功恢复入口。专利技术交底另存本机私有目录，未提交申请，未确认可专利性。
