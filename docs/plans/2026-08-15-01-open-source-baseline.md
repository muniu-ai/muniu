# 子计划 01：仓库与开源基线实现计划

> **致 Claude：** 必须使用子技能 dev-executing-plans 逐任务执行此计划。

**目标：** 把现有源码快照整理为可公开审计、可重复安装、测试全绿的 Muniu v0.1.0 基线。

**架构：** 不改变产品行为，只建立开源治理、来源追踪、统一包元数据、可复现依赖和最小权限 CI。唯一行为性修复限定为测试时钟确定性和兼容的 Fastify 安全升级。

**技术栈：** Git worktree、Node.js 22.19.x、npm 11.10.1、TypeScript 5.7、GitHub Actions、Cargo。

---

## 依赖

- 基线提交 4f00f46e3d80ca3e4af51e0ede467b97827e9822。
- 不创建远程、不推送、不公开仓库；组织配置属于子计划 06 的外部前置条件。

## 任务

1. 创建总设计和 01 至 06 子计划，并新增根 AGENTS.md。
2. 补齐 Apache-2.0、NOTICE、DCO、第三方许可、贡献、安全、行为准则、支持、治理和 GitHub 模板。
3. 建立 DeepSeek Harness 固定提交 provenance，记录计划迁入核心簇与排除项。
4. 扩展 .gitignore；清理本机绝对路径、旧仓库 URL、updater 发布误导和镜像 registry。
5. 将所有第一方 workspace 标记 private:true、0.1.0、Apache-2.0、新仓库 URL；同步 Cargo 元数据。
6. 先运行 Governance 测试观察 WAIVER_SCOPE_MISMATCH 被 WAIVER_EXPIRED 替代，再仅给相关断言传入固定 now，保持生产代码不变。
7. 先记录 npm audit 的 fast-uri/find-my-way High，再升级到修复版兼容 Fastify 5.x，更新 lock 并运行 API 测试。
8. 增加 Node 22.19/npm 11.10.1、最小权限、Node/desktop/Rust/enterprise/audit/secret/license 门禁；Action 只使用经官方远程确认的 commit SHA。
9. 执行全量验证、自审和扫描，分成治理基线与依赖/CI 两个清晰提交。

## 测试命令

~~~sh
npm ci
npm run test -w @mn/governance
npm run test -w @mn/api
npm run typecheck
npm test
npm run typecheck:desktop
npm run build:desktop
(cd apps/desktop-mac/src-tauri && cargo test --locked)
npm run verify:enterprise-fixture
npm audit --omit=dev
git diff --check
~~~

## 退出门槛

所有命令通过；production audit 零 Critical/High；许可证、秘密、绝对路径和大文件扫描无阻断；git status 干净。完成后才允许执行子计划 02。
