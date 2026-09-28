# 密钥扫描

CI 使用固定版本的 gitleaks 扫描完整 Git 历史，再运行仓库扫描器检查当前工作树。两道检查都失败关闭，业务数据脱敏规则不能放宽凭据检测。

## 本地检查

安装仓库指定版本的 gitleaks 后运行：

```bash
gitleaks git \
  --config .gitleaks.toml \
  --redact \
  --no-banner \
  --log-opts=--all
npm run verify:oss-baseline
npm run test:oss-policy
```

`--log-opts=--all` 要求完整历史可用。浅克隆不能作为发布扫描结果。

## 发现处理

1. 立即停止提交或发布，不在 issue、聊天或日志中复制 secret。
2. 判断是否为真实凭据；无法确认时按真实泄露处理。
3. 撤销并轮换凭据，再清理工作树和必要的历史。
4. 重新运行完整历史与当前树扫描。
5. 记录不含 secret 的影响范围、轮换时间和验证证据。

仅从最新提交删除 secret 不足以处理已经进入 Git 历史的凭据。

## Allowlist

例外必须同时限定 rule ID、锚定路径和精确值表达式。历史导入例外还必须固定到引入该发现的完整 commit ID。禁止目录级、规则级、熵级或通配值排除。

测试目录不会自动获得例外。合成 fixture 应明显不可用于真实服务，并由测试证明它触发预期的拒绝或脱敏行为。任何新增或不确定发现都阻断构建，不能为了让 CI 通过而直接加入 allowlist。

### CI 36411326688 发现复核

2026-09-28 复核的 26 条 `generic-api-key` 发现均为公开测试数据或代码标识。新增例外按原始提交、单个文件、检测规则和逐项精确值共同匹配，不豁免目录或后续提交。

| 原始提交 | 文件与发现数 | 核验依据 |
| --- | --- | --- |
| `466793846bf3296ae8cf3b44ea6d4f0ae6d39f88` | `docs/industry-delivery/integration-results.json`，16 条 | 报告中的 `operationKey` 是业务幂等摘要；`computeBusinessOperationKey` 对规范化业务字段计算 SHA-256，不用于认证 |
| `ad18e593c2a95ba92c32c5af1d01837373004bbe` | 同一报告，4 条 | 同一业务幂等摘要字段，来自隔离的工业集成 fixture |
| `89eb29591a6f9294faa3aa379debb47a6d6bbc3c` | `apps/host/src/execution-metering.ts`、`apps/worker/src/model-invoker.ts`、`apps/worker/test/model-usage.test.ts`，各 1 条 | 输入 token 计数依据的固定枚举；实现和测试均用于区分厂商计数与保守估算 |
| `049203831723206ef08402c2bcd4f9b80cb7b58f` | `docker-compose.enterprise.yml`、`deploy/kind/enterprise-fixture.yaml`，各 1 条 | 固定 HMAC 测试值，解码后为明确的企业 fixture 标签；仅供测试部署，不能用于生产 |
| `958a4612eb98def38ced61c43ff82c9c3aac5e83` | `apps/api/src/migrateAppServerV3.ts`，1 条 | S3 环境配置辅助函数的导入名称，不是凭据 |

`scripts/test/secret-scanning.test.mjs` 从这些固定提交读取已复核内容，检查例外的规则、路径、提交和完整值集合。断言只报告范围变化，不输出匹配值。该测试随 `npm run test:oss-policy` 执行；真实扫描仍保留 CI 的完整历史扫描。

本地 `--all` 还会扫描尚未推送的分支。结果与 CI 不同时，先比较两侧可达提交，不能把额外的本地发现直接加入发布例外，也不能通过删除历史、排除整个分支或跳过扫描制造通过结果。核验扫描日志中的提交数和错误信息；空扫描或 Git 错误不能仅凭退出码判定通过。

## 输出

扫描报告、CI 日志和发布说明必须使用 `--redact` 或等价处理。不要上传包含匹配值的原始报告。需要协作调查时，只共享规则、文件路径、commit ID 和已经轮换的凭据类型。
