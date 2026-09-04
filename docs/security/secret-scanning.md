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

## 输出

扫描报告、CI 日志和发布说明必须使用 `--redact` 或等价处理。不要上传包含匹配值的原始报告。需要协作调查时，只共享规则、文件路径、commit ID 和已经轮换的凭据类型。
