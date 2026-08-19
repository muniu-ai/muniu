# v0.1 迁移指南

1. 备份 `~/.mniu` 和 API state 文件。
2. 首次启动会把 `~/.mniu` 原子改名为 `~/.muniu`。
3. 状态快照 V1/V2 会生成 `.v1.bak` 或 `.v2.bak`，再写入 V3。
4. 旧执行策略确定性转换为 `ExecutionStrategyV2.targets`。
5. 深链改用 `muniu://`；`mniu://` 仅保留一个兼容版本。
6. 默认 candidate runtime 改为 `builtin`，必须配置 provider/model。若需旧 CLI，显式使用 `claude` 或 `codex` target。
7. 动态插件安全模型改为“管理员信任、与宿主等权”，不再宣称禁用 HMR 或可执行配置。

迁移失败时原快照不会被覆盖。不要删除备份，先修复损坏或不兼容数据后重试。
