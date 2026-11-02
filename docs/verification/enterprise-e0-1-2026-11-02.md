# 企业经营平台 E0.1 架构与契约验证

日期：2026-11-02。基线：`e9f8ffc92a9045e6b072953c8fdca207b94541e8`。分支：`codex/enterprise-e0-1`。当前状态：E0.1 出口通过。

## 实现范围

- 登记完整实施计划与授权，新增 ADR 0015，并标明旧架构决定的替代范围。
- 公开响应改为 schema 生成 DTO，保留既有接口语义与严格响应检查；输入、输出及企业类型统一通过 `generate:contracts` 更新。
- 冻结企业核心结构、五端口 SDK 声明、规划接口目录、13 类正例和撤权、过期版本验收规格。
- 同步私有企业服务和 Worker 编排依赖规则。保留 Host 组合根及产品插件公共 SDK 边界。

原方案工作树保留原样。没有改动用户状态、Sales、生产资源或上游代码。没有挂载新的企业 HTTP 路由。

## 验证记录

生成器测试先因缺少实现失败；企业契约测试先因入口不存在失败。实现后执行下列检查。现有 HTTP 操作展开 schema 引用后与基线逐项一致。

| 命令 | 结果 |
| --- | --- |
| `npm ci` | 通过；Node 22.19.0、npm 11.10.1；安装报告 5 项开发依赖相关漏洞；生产依赖审计为 0 |
| `node --test scripts/test/schema-types.test.mjs scripts/test/enterprise-contracts.test.mjs` | 通过 |
| `npm run test -w @mn/contracts` | 首轮 32 项通过；待最终复验 |
| `npm run build` | 首轮全部 Node 工作区通过；待最终复验 |
| `npm run test:boundaries` | 通过 |
| `npm run typecheck`、`npm run typecheck:desktop` | 待运行 |
| `npm run docs:check`、`npm run docs:links`、`npm run docs:build` | 待运行 |
| `git diff --check` | 待运行 |

前两轮 `npm test` 均在 Host 的真实沙箱团队场景超过 15 秒期限，其他已执行检查通过。该场景独立执行通过；限制两个测试进程后 Host 423 项全部通过。Host 的测试入口因此固定 `--test-concurrency=2`，保留原断言、沙箱要求和期限；随后完整 `npm test` 通过。没有删除或跳过失败场景。

Desktop 与文档构建提示现有大体积 chunk，构建成功。Rust、企业 Docker/Kind、真实 Sales、企业微信和模型试点评测未在 E0.1 执行。

## 验收边界与下一包

结构检查不执行实际授权、对象版本查询、领域金额计算、模型调用或连接器写入。撤权、过期版本示例是 E1—E5 的验收规格，不能计为真实权限、恢复或双系统测试通过。

E0.2 在独立工作树冻结 B01—U01、两模式合成任务集、人工基线、留出集和旧测试覆盖映射。E1—E8 仍未完成，真实企业依赖、双系统、企业微信、容量、模型质量及试点验证均不能由本记录代替。
