# Agent Runtime

`@mn/agent-runtime` 是 Agent OS 0.2 的 Agent 执行层，提供 Scope、会话视图、持久收件箱和预算控制。该包定义执行语义与持久化端口，不持有数据库、网络服务或产品领域逻辑，由 Host 和 Worker 注入实现。

## 代码入口

| 文件 | 职责 |
| --- | --- |
| [src/agent.ts](src/agent.ts) | `AgentHandle` 的执行、补充输入、调整方向、取消与恢复 |
| [src/scope.ts](src/scope.ts) | `AgentScope`、贡献解析与 generation |
| [src/inbox.ts](src/inbox.ts) | 持久输入队列 |
| [src/session.ts](src/session.ts) | Session Log、Surface 与模型可见上下文 |
| [src/store.ts](src/store.ts) | `RuntimeStore` 实现和注入的投影存储适配 |
| [src/model-budget.ts](src/model-budget.ts) | 模型请求前预算预留与用量结算 |

## 执行边界

模型上下文在请求前持久化。`follow_up` 排入下一轮，`steer` 在模型边界应用；恢复只能使用已提交记录。Scope、权限和预算按父子关系收窄，未知工具结果保留人工核对要求。

`KernelProjectionRuntimeStore` 通过端口访问持久状态；生产加密、事务和事件重建由 Host 与存储实现装配。使用内存实现的测试不证明数据库恢复行为。完整语义见[架构](../../docs/architecture.md#agent-与-session)，术语见[核心概念](../../docs/concepts.md)。

## 验证

按[贡献指南](../../CONTRIBUTING.md)安装依赖，在仓库根目录完成 `npm run build` 后执行：

```bash
npm run test -w @mn/agent-runtime
npm run typecheck -w @mn/agent-runtime
```

涉及持久化、模型调用或中断恢复的变更，还需检查 [Host](../../apps/host/README.md) 与 [Worker](../../apps/worker/README.md) 的适配和测试。
