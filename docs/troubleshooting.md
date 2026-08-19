# 故障排查

- `MODEL_*`：确认 provider 已启用、支持 `agent` consumer，model 在目录中。
- `RUNTIME_OVERLAY_REQUIRED`：本地旧会话没有可恢复的模型 overlay；创建新会话。企业 S3 会话会保存 overlay。
- 插件 reload 失败：运行 `mn profile validate`，检查 `~/.muniu/runtime/plugin-audit.jsonl`，旧 runtime 会继续服务。
- `S3 ... tampered`：不要绕过校验；核对 bucket version、对象大小和 PostgreSQL 摘要。
- Worker 无法 claim：比较 `/v1/run-jobs/workers` 的 runtime、Gate、语言、工具和 sandbox capability。
- 企业 `/healthz` 503：先检查 PostgreSQL read/write，再检查 OIDC、S3 和 OTLP 配置。
