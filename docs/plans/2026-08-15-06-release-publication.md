# 子计划 06：发布工程与公开发布实现计划

> **致 Claude：** 必须使用子技能 dev-executing-plans 逐任务执行此计划。

**目标：** 由受保护 CI 生成、验证并发布 Muniu v0.1.0 Developer Preview 源码、macOS portable 包和 GHCR demo 镜像。

**架构：** build once/publish exact bytes；源码由 git archive 产生，portable 包仅含编译运行时与 production 依赖，镜像仅定位 API/demo。每个制品配套 CycloneDX SBOM、SHA256 和 release manifest。

**技术栈：** GitHub Actions、GitHub Releases、GHCR、CycloneDX、Docker Buildx。

---

## 依赖与任务

- 依赖 01 至 05 全部退出门槛，以及用户控制的 muniu-ai 组织、2FA 和发布权限。
- 先写解包烟测，再实现 source、macOS arm64/x64 portable、BUILD-INFO、SBOM、SHA256SUMS 和 release-manifest 构建。
- 固定制品名为 muniu-v0.1.0-source.tar.gz、muniu-v0.1.0-node22-macos-arm64.tar.gz、muniu-v0.1.0-node22-macos-x64.tar.gz，并发布 ghcr.io/muniu-ai/muniu:v0.1.0。
- portable 不内嵌 Node，不含源码、测试、map、开发依赖、Tauri 二进制或缓存。
- GHCR 多架构镜像仅承诺在受支持 macOS 的 Docker Desktop 使用。
- CI 固定 Action SHA、最小权限和 release environment 审批；受保护 main 与不可变 v0.1.0 标签才能发布。
- 发布环境的 DeepSeek live smoke 使用专用密钥和最小合成提示，不发送项目源码。
- 发布日志、SBOM、manifest、portable 与镜像扫描同时验证数据策略：业务样例仅手机号/身份证号脱敏；API key、token、password、private key 等凭据始终隐藏且 raw/debug 不可绕过。
- 公开前启用 branch/tag ruleset、DCO、Dependabot、secret scanning/push protection 和 private vulnerability reporting。

## 测试命令与退出门槛

~~~sh
npm ci
npm test
npm audit --omit=dev
./scripts/verify-release-artifacts.sh dist/release/v0.1.0
~~~

两个 portable 包在仓库外完成 mn --version、mn --help、API /healthz、mn doctor 和 mock Agent；源码包可重建；制品与 CI 日志的凭据扫描为零，业务脱敏 fixture 只改变手机号/身份证号；所有 hash/SBOM 匹配后方可公开仓库并创建不可覆盖的 v0.1.0 Release。
