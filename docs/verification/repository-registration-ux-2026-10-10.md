# 仓库登记体验验证记录

日期：2026-10-10。源码基线：`41762ac`。范围见[实施计划](../proposals/repository-registration-ux-2026-10-10.md)。

## 行为

快速捕获的 Coding 类型提供“登记仓库”或“添加仓库”入口，Coding 仓库列表复用同一窗口。桌面版可选择本机文件夹，浏览器可填写绝对路径。登记后自动选中目标仓库并保留任务草稿。

窗口取消、目录选择取消、原生选择失败后手填、中文及空格路径、重复路径复用、多个仓库的明确选择，以及真实 Host 写入成功但响应丢失后的同键重试均通过 UI 回归。登记仍只保存路径，未扩大插件或文件系统权限，未修改执行前的仓库检查与沙箱策略。

## 检查结果

| 检查 | 结果 |
| --- | --- |
| 锁定依赖安装 | `npm ci` 通过；Node.js 22.19.0、npm 11.10.1、TypeScript 5.7.2 |
| `npm test` | 796 项通过，0 失败 |
| `npm run typecheck` | 通过 |
| `npm run typecheck:desktop`、`npm run build:desktop` | 通过 |
| `npm run verify:repositories-ui` | 通过；真实 Host，目录选择桥接在浏览器测试中模拟 |
| `npm run verify:coding-ui`、`npm run verify:onboarding-ui` | 通过 |
| Rust crate 下 `cargo fmt --check`、`cargo test --locked` | 通过，9 项测试通过 |
| `npm audit --omit=dev` | 0 项漏洞 |
| 文档检查、链接和构建 | 通过 |
| `npm run verify:enterprise-fixture` | 静态与 Helm 检查通过；容器阶段未完成，当前 shell 的 Docker 链接失效，已安装 Docker 的守护进程也未运行 |
| universal macOS 应用 | arm64/x86_64 构建与本地签名校验通过 |
| `npm run verify:mac-packaged-app` | 新应用的隔离 Host、首次设置重放与经营流程通过；脚本同时校验的是已有 DMG，本次未重新生成 DMG |
| 本机原生选择器 | `/Applications/木牛.app` 实测目录选择、路径回填、取消后保留路径、取消登记通过 |

TDD 首次运行因快速捕获缺少“登记仓库”按钮而失败；实现后通过。一次 Coding UI 回归与构建并行，热更新销毁了页面执行上下文；构建完成后顺序重跑通过。

## 本机安装

安装前备份原应用与 `~/.muniu/v2`，更新至 `/Applications/木牛.app`，校验主程序、Host 和图标的文件摘要与构建产物一致。启动后 `doctor` 检查通过。原生验证选择本机源码目录后取消登记，没有创建业务记录或执行 Coding 任务。

本次为本地开发签名安装，未进行 Apple Developer ID 公证或远程发布。
