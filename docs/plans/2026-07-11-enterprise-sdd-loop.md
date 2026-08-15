# mn 企业 Spec–Harness–Loop 实现计划

> **致执行者：** 必须使用子技能 dev-executing-plans 逐任务执行此计划。

**目标：** 在兼容 `classic-v1` 的前提下，实现版本化 Spec、企业规范、Harness、真实 Gate、有界 Loop、证据/学习和 local/enterprise 双 profile。

**架构：** 新增 Specs、Governance、Harness 三个纯领域包，以不可变 digest 快照连接 API/Worker。现有 orchestrator 保留为 `classic-v1`，新的 governed workflow 通过受限 registry 驱动阶段与 Gate。所有企业配置最终解析为单一 GovernanceSnapshot，远程包仅含声明式数据。

**技术栈：** TypeScript 5、Node.js、Fastify/Zod、现有 file/SQLite store、PostgreSQL enterprise adapter、Tauri/React、Docker Compose 测试环境。

---

## 执行纪律

每个任务按 `失败测试 -> 最小实现 -> 定向测试 -> 相关回归 -> 更新 task/evidence` 执行。当前工作副本没有 Git 元数据，因此跳过提交步骤并在每个任务记录精确文件与验证命令。

## 任务批次

### 批次 1：领域基座

- T001：状态目录、ADR 0004-0008、实现计划。
- T002：创建 `packages/specs`，实现 Spec/Revision/Acceptance 类型、canonical digest、schema validation 与单测。
- T004：创建 `packages/governance`，实现 Standard Pack、Waiver、单调作用域合并、GovernanceSnapshot 与单测。

### 批次 2：持久化与 Harness

- T003：实现 Spec revision repository、Spec Kit import/export 和 legacy adapter。
- T005：泛化签名 registry、pack lock、dry-run/diff/rollback。
- T006：创建 `packages/harness`，实现 ContextSource/Gate/Sandbox capability registry 与 deterministic Harness compiler。

### 批次 3：Core、API、CLI

- T007：扩展 `AgentTask`/`RunRecord`，保留旧字段并增加 spec/workflow/harness/snapshot/stage/budget。
- T008：扩展 store snapshot v2，新增 capabilities、Spec、Standard Pack、effective governance、policy explain API。
- T009：新增 standards/spec/policy/workflow/audit CLI，并保留旧命令输出。

### 批次 4：微服务与验证

- T010：读取 `.mn/project.yaml`，增强 owner/contract/dependency/migration discovery 和影响矩阵。
- T011：GateResultV2、runner registry、evidence artifact 与 enterprise fail-closed。
- T012：实现 Spec、protected path、OpenAPI/AsyncAPI、migration safety、安全命令适配器。
- T013：worker capability、sandbox enforcement level 和 capability-aware claim。

### 批次 5：Loop 与学习

- T014：`classic-v1` 适配和 `governed-increment-v1` 阶段持久化。
- T015：失败分类、repair、预算、无进展停止、人工升级和 stage resume。
- T016：Eval Asset、Trace Graph、drift 检测、Learning Proposal/Promotion。

### 批次 6：体验与企业 profile

- T017：Desktop 从 capabilities/effective governance 动态渲染，并展示 Spec/Stage/Evidence/Learning。
- T018：RequestContext、tenant、OIDC/JWT、RBAC/ABAC、CORS fail-closed、AuditEvent。
- T019：Postgres repository/queue/outbox、S3-compatible artifact、OTel 与 compose profile。

### 批次 7：验收

- T020：把 `examples/microservice-repo` 建为两个真实服务并覆盖一正四负企业场景。
- T021：v1->v2 migration、README/technical docs、root validation、enterprise E2E、独立 Full-V 和缺口回环。

## 每批通用验证

```bash
npm run typecheck -w <changed-workspace>
npm run test -w <changed-workspace>
npm run build
npm run typecheck
npm test
```

桌面和企业批次另运行对应桌面 verifier 与 Docker Compose E2E。任何失败先写入 task/evidence，再修复；不得降低 Gate 或删除测试换取通过。
