# 木牛品牌标识验证记录

日期：2026-10-09。源码基线：`7af4956`。范围见[替换计划](../proposals/brand-logo-2026-10-09.md)。

## 资源与显示

用户指定的透明底 Logo 保存为 `assets/brand/muniu-logo.png`，与提供的原文件逐字节一致；SHA-256 为 `f23ecb8a0278ab80df9df3ab6c64a25a65fc991974ee0fd6ed2a66378496d3fa`。Desktop 与文档站使用相同原图。

启动图标由原图与白色圆角底组成，保留比例、颜色和透明外边距。Tauri 生成已有的各平台图标尺寸，macOS 显式打包 ICNS，托盘复用应用图标。首次设置、展开侧栏、收起侧栏已通过截图检查，没有裁切或遮挡；网页与文档图标也使用白底版本。

## 检查结果

| 检查 | 结果 |
| --- | --- |
| `npm ci` 与锁定工具链 | Node.js 22.19.0、npm 11.10.1、TypeScript 5.7.2 |
| `npm test` | 796 项通过，0 失败 |
| `npm run typecheck` | 通过 |
| Desktop 类型检查与构建 | 通过 |
| 首次设置 UI 流程 | 91 次真实 Host 请求通过，三处品牌显示人工核验通过 |
| `cargo test --locked` | 9 项通过 |
| `npm audit --omit=dev` | 0 项漏洞 |
| 文档生成、链接与构建 | 通过 |
| 企业 fixture | 静态检查 22 项与 Helm 4 项通过；容器阶段因未安装 Docker 而未完成 |
| universal macOS 应用 | arm64/x86_64 构建、本地签名校验、隔离 Host 首次设置与重放、经营流程均通过 |

本轮只更新品牌资源和显示，不修改模型、Agent 调度或经营行为。未重新生成公开发行 DMG，也未做 Apple Developer ID 公证。

## 本机安装

已备份原应用与 `~/.muniu/v2`，安装至 `/Applications/木牛.app`。主程序、Host 与 ICNS 摘要均匹配构建产物，`CFBundleIconFile` 指向新图标。原生窗口已显示新 Logo，Finder 的应用简介和预览也已显示白底图标。冷启动正常，`doctor` 返回 healthy、ready，未发现服务问题。
